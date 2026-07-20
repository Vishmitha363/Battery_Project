document.getElementById("registerForm").addEventListener("submit", function(e){

e.preventDefault();

const fullname=document.getElementById("fullname").value.trim();
const email=document.getElementById("email").value.trim();
const username=document.getElementById("username").value.trim();
const password=document.getElementById("password").value;
const confirm=document.getElementById("confirm").value;

if(password!==confirm){

document.getElementById("message").innerHTML="Passwords do not match.";

return;

}

let users=JSON.parse(localStorage.getItem("users")) || [];

let exists=users.find(user=>user.username===username);

if(exists){

document.getElementById("message").innerHTML="Username already exists.";

return;

}

users.push({

fullname:fullname,

email:email,

username:username,

password:password

});

localStorage.setItem("users",JSON.stringify(users));

alert("Registration Successful!");

window.location.href="login.html";

});